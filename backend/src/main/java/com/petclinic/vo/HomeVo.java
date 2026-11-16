package com.petclinic.vo;

import com.petclinic.entity.Department;
import com.petclinic.entity.Notice;
import lombok.Data;

import java.util.List;

/**
 * 用户端首页一次性要用的三块数据。移动端首屏打一个请求比打四个快，
 * 也省得前端拼三个 loading。
 */
@Data
public class HomeVo {

    private List<Department> departments;
    private List<DoctorVo> doctors;
    private List<Notice> notices;
}
