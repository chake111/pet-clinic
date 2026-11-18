package com.yuzhua.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.yuzhua.entity.Department;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

public interface DepartmentMapper extends BaseMapper<Department> {

    /**
     * 锁定一条仍在使用的科室行，供"删除科室"与"写入医生归属"共用。
     *
     * <p>两条路径原本各自做"先查后写"：删除方数完挂靠医生再删，新增方确认科室存在再插。
     * 两次检查落在不同事务里就可能同时通过，留下指向已删科室的医生。
     * 现在双方都先取这一把行锁，检查与写入被串到同一个临界区。
     *
     * <p>必须是锁定读（当前读），不能用 {@code selectById}：快照读在等待锁之后
     * 仍可能读到等待前的旧版本。
     */
    @Select("SELECT * FROM department WHERE id = #{id} AND deleted = 0 FOR UPDATE")
    Department selectByIdForUpdate(@Param("id") Long id);
}
