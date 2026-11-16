package com.petclinic.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.petclinic.entity.Pet;
import com.petclinic.vo.PetDisplayVo;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.util.Collection;
import java.util.List;

public interface PetMapper extends BaseMapper<Pet> {

    /**
     * 历史业务记录展示专用：按编号批量取昵称、种类、品种、头像；编号来自已通过权限校验的
     * 业务记录，空集合直接返回空结果（拼 1 = 0），不会拼出 IN () 语法错误。
     *
     * 契约动机: 历史可读性与写入限制成对——不过滤逻辑删除，档案删了旧预约、病历、问诊里的
     * 宠物名还得显示；正因返回行可能属于已删档案，只许展示消费，写入路径必须走归属校验。
     */
    @Select("<script>"
            + "SELECT id, name, species, breed, avatar FROM pet WHERE "
            + "<choose>"
            + "<when test='ids != null and ids.size() > 0'>"
            + "id IN <foreach collection='ids' item='pid' open='(' separator=',' close=')'>#{pid}</foreach>"
            + "</when>"
            + "<otherwise>1 = 0</otherwise>"
            + "</choose>"
            + "</script>")
    List<PetDisplayVo> selectHistoryDisplay(@Param("ids") Collection<Long> ids);
}
